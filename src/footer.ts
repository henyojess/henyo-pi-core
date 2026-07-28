/* global process */
import type { Component, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type {
  ReadonlyFooterDataProvider,
  ContextUsage,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

/**
 * A compact one-line footer component that renders:
 *   model · context% · pwd · branch
 *
 * Segments are separated by `· ` (middle dot + space).
 * Hidden segments (no branch) are omitted entirely.
 * Model is left-aligned (always visible on the left).
 * Context percentage is color-coded: green (<70%), yellow (70-90%), red (>90%).
 * All non-model text is dimmed.
 * Truncation: when space is tight, pwd and branch are truncated from the right,
 *   model and context stay visible on the left.
 */
class FooterComponent implements Component {
  private _focused = false;
  private _dirty = true;
  private _cachedLine = '';
  private _theme: Theme | null = null;

  constructor(
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly ctx: ExtensionContext,
  ) {
    // Subscribe to branch changes so we re-render when the branch changes
    this.footerData.onBranchChange(() => {
      this.invalidate();
    });
  }

  /** Initialize the component with the theme (called by factory). */
  init(theme: Theme): void {
    this._theme = theme;
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  invalidate(): void {
    this._dirty = true;
  }

  dispose(): void {
    // Nothing to clean up — branch subscription is managed by the provider
  }

  /** Get the current context usage, or undefined if unknown (e.g. right after compaction). */
  private getContextUsage(): ContextUsage | undefined {
    return this.ctx.getContextUsage();
  }

  /** Get the current working directory path segments (for growing). */
  private getCwdParts(): string[] {
    const full = this.ctx.sessionManager.getCwd().replace(process.env.HOME ?? '', '~');
    return full.split('/').filter(Boolean);
  }

  /**
   * Build cwd string, growing from right within available space.
   * Returns styled cwd that fits within maxWidth.
   */
  private buildCwd(cwdParts: string[], maxWidth: number, theme: Theme): string {
    // Grow cwd from the right, adding segments until we hit maxWidth
    let result = '';
    for (let i = cwdParts.length - 1; i >= 0; i--) {
      const candidate = cwdParts.slice(i).join('/');
      const styled = theme.fg('dim', candidate);
      if (visibleWidth(styled) <= maxWidth) {
        result = styled;
      } else {
        break;
      }
    }
    return result;
  }

  /** Get the current git branch. */
  private getBranch(): string | null {
    return this.footerData.getGitBranch()?.trim() || null;
  }

  /** Get the current model ID. */
  private getModel(): string {
    return this.ctx.model?.name ?? 'no-model';
  }

  /**
   * Build the rendered footer line.
   * Layout: model · context% · pwd · branch
   * Model is left-aligned (always visible). Cwd/branch grow from the right.
   * @param width - Available terminal width
   */
  private buildLine(width: number): string {
    const theme = this._theme;
    if (!theme) return '';

    const cwdParts = this.getCwdParts();
    const branch = this.getBranch();
    const contextUsage = this.getContextUsage();
    const model = this.getModel();

    // ── Build left content (model · context%) ─────────────────────────
    let leftContent = theme.fg('dim', model);
    let leftWidth = visibleWidth(model);
    if (contextUsage) {
      let ctxStr: string;
      let ctxColor: 'dim' | 'success' | 'warning' | 'error' = 'dim';
      if (contextUsage.tokens !== null && contextUsage.percent !== null) {
        const tokensK = contextUsage.tokens >= 1000 ? `${Math.round(contextUsage.tokens / 1000)}k` : contextUsage.tokens;
        ctxStr = `${Math.round(contextUsage.percent)}%/${tokensK}`;
        const pct = Math.round(contextUsage.percent);
        if (pct < 70) ctxColor = 'success';
        else if (pct < 90) ctxColor = 'warning';
        else ctxColor = 'error';
      } else {
        const ctxWindow = contextUsage.contextWindow >= 1000
          ? `${Math.round(contextUsage.contextWindow / 1000)}k`
          : contextUsage.contextWindow;
        ctxStr = `?/${ctxWindow}`;
      }
      leftContent = leftContent + '·' + theme.fg(ctxColor, ctxStr);
      leftWidth += 1 + visibleWidth(ctxStr);
    }

    // ── Build right content (pwd · branch) ────────────────────────────
    const cwdFor = (idx: number): string => {
      const parts = cwdParts.slice(idx).join('/');
      return idx === 0 ? '/' + parts : parts;
    };

    if (!branch) {
      // No branch — just cwd, right-aligned
      let bestCwdIdx = cwdParts.length - 1;
      for (let i = cwdParts.length - 1; i >= 0; i--) {
        const cwdCandidate = cwdFor(i);
        const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));
        if (cwdWidth <= width - leftWidth) {
          bestCwdIdx = i;
        } else {
          break;
        }
      }
      const cwdCandidate = cwdFor(bestCwdIdx);
      const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));
      const padding = Math.max(0, width - leftWidth - cwdWidth);
      return leftContent + ' '.repeat(padding) + theme.fg('dim', cwdCandidate);
    }

    // Branch present — cwd · branch, right-aligned
    // Start with minimum cwd (last segment), grow left
    let bestCwdIdx = cwdParts.length - 1;
    let bestPadding = 0;

    for (let i = cwdParts.length - 1; i >= 0; i--) {
      const cwdCandidate = cwdFor(i);
      const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));
      const branchWidth = visibleWidth(theme.fg('dim', branch));
      const totalWidth = cwdWidth + 1 + branchWidth;
      const padding = (width - leftWidth) - totalWidth;

      if (padding >= 1) {
        bestCwdIdx = i;
        bestPadding = padding;
      } else if (padding === 0 && bestCwdIdx === i) {
        bestPadding = 0;
      } else {
        break;
      }
    }

    const cwdCandidate = cwdFor(bestCwdIdx);
    const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));

    let finalBranch = branch;
    let finalBranchWidth = visibleWidth(theme.fg('dim', branch));

    // If padding is 0, truncate branch to ensure padding >= 1
    if (bestPadding === 0) {
      const maxBranchWidth = (width - leftWidth) - cwdWidth - 1 - 1;
      if (maxBranchWidth > 0) {
        finalBranch = truncateToWidth(branch, maxBranchWidth, '');
        finalBranchWidth = visibleWidth(finalBranch);
      }
    }

    const padding = Math.max(0, (width - leftWidth) - cwdWidth - 1 - finalBranchWidth);
    return leftContent + ' '.repeat(padding) + theme.fg('dim', cwdCandidate) + '·' + finalBranch;
  }

  /** Render the footer as a single line. */
  render(width: number): string[] {
    this._dirty = true;
    if (this._theme) {
      this._cachedLine = this.buildLine(width);
    }
    return [this._cachedLine];
  }
}

/**
 * Factory function that creates a FooterComponent instance.
 * Captures the ExtensionContext via closure.
 *
 * @param tui - TUI instance (for requestRender on branch changes)
 * @param theme - Theme instance for styling
 * @param footerData - Read-only footer data provider (git branch, extension statuses)
 * @param ctx - Extension context (model, session, etc.)
 * @returns A Component instance that renders the compact footer
 */
export const FooterFactory = (
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  ctx: ExtensionContext,
): Component & { dispose?(): void } => {
  const component = new FooterComponent(footerData, ctx);

  // Initialize with the theme
  component.init(theme);

  // Subscribe to branch changes so we re-render when the branch changes
  footerData.onBranchChange(() => {
    tui.requestRender();
  });

  return component;
};
