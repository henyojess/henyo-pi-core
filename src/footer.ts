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
 *   pwd · branch · context% · model
 *
 * Segments are separated by `· ` (middle dot + space).
 * Hidden segments (no branch, no model) are omitted entirely.
 * Model is right-aligned with space padding.
 * Context percentage is color-coded: green (<70%), yellow (70-90%), red (>90%).
 * All non-context text is dimmed.
 * Truncation: if total width > terminal width, truncate from the left (pwd goes first),
 *   model stays right-aligned.
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
   * @param width - Available terminal width
   */
  private buildLine(width: number): string {
    const theme = this._theme;
    if (!theme) return '';

    const cwdParts = this.getCwdParts();
    const branch = this.getBranch();
    const contextUsage = this.getContextUsage();
    const model = this.getModel();

    // Build right content (context + model)
    let rightContent = theme.fg('dim', model);
    let rightWidth = visibleWidth(model);
    if (contextUsage) {
      if (contextUsage.tokens !== null && contextUsage.percent !== null) {
        const tokensK = contextUsage.tokens >= 1000 ? `${Math.round(contextUsage.tokens / 1000)}k` : contextUsage.tokens;
        const ctxStr = `${Math.round(contextUsage.percent)}%/${tokensK}`;
        const pct = Math.round(contextUsage.percent);
        if (pct < 70) {
          rightContent = theme.fg('success', ctxStr) + '·' + rightContent;
        } else if (pct < 90) {
          rightContent = theme.fg('warning', ctxStr) + '·' + rightContent;
        } else {
          rightContent = theme.fg('error', ctxStr) + '·' + rightContent;
        }
        rightWidth += visibleWidth(ctxStr) + 1;
      } else {
        const ctxWindow = contextUsage.contextWindow >= 1000
          ? `${Math.round(contextUsage.contextWindow / 1000)}k`
          : contextUsage.contextWindow;
        const ctxStr = `?/${ctxWindow}`;
        rightContent = theme.fg('dim', ctxStr) + '·' + rightContent;
        rightWidth += visibleWidth(ctxStr) + 1;
      }
    }

    // Available width for left part (cwd·branch)
    const availableLeftWidth = Math.max(0, width - rightWidth);

    const cwdFor = (idx: number): string => {
      const parts = cwdParts.slice(idx).join('/');
      return idx === 0 ? '/' + parts : parts;
    };

    if (!branch) {
      // No branch — just show cwd
      let bestCwdIdx = cwdParts.length - 1;
      for (let i = cwdParts.length - 1; i >= 0; i--) {
        const cwdCandidate = cwdFor(i);
        const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));
        if (cwdWidth <= availableLeftWidth) {
          bestCwdIdx = i;
        } else {
          break;
        }
      }
      const cwdCandidate = cwdFor(bestCwdIdx);
      const padding = Math.max(0, availableLeftWidth - visibleWidth(theme.fg('dim', cwdCandidate)));
      return cwdCandidate + ' '.repeat(padding) + rightContent;
    }

    // Start with minimum cwd (last segment), grow left while maintaining padding >= 1
    let bestCwdIdx = cwdParts.length - 1;
    let bestPadding = 0;

    for (let i = cwdParts.length - 1; i >= 0; i--) {
      const cwdCandidate = cwdFor(i);
      const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));
      const branchWidth = visibleWidth(theme.fg('dim', branch));
      const totalWidth = cwdWidth + 1 + branchWidth;
      const padding = availableLeftWidth - totalWidth;

      if (padding >= 1) {
        bestCwdIdx = i;
        bestPadding = padding;
      } else if (padding === 0 && bestCwdIdx === i) {
        // First iteration with padding 0 — keep but mark for truncation
        bestPadding = 0;
      } else if (padding < 0) {
        // Can't fit, stop
        break;
      } else {
        // padding < 0 but we already found a better cwd, stop
        break;
      }
    }

    const cwdCandidate = cwdFor(bestCwdIdx);
    const cwdWidth = visibleWidth(theme.fg('dim', cwdCandidate));

    let finalBranch = branch;
    let finalBranchWidth = visibleWidth(theme.fg('dim', branch));

    // If padding is 0, truncate branch to ensure padding >= 1
    if (bestPadding === 0) {
      const maxBranchWidth = availableLeftWidth - cwdWidth - 1 - 1; // -1 for padding
      if (maxBranchWidth > 0) {
        finalBranch = truncateToWidth(branch, maxBranchWidth, '');
        finalBranchWidth = visibleWidth(finalBranch);
      }
    }

    const padding = Math.max(0, availableLeftWidth - cwdWidth - 1 - finalBranchWidth);
    return cwdCandidate + '·' + finalBranch + ' '.repeat(padding) + rightContent;
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
