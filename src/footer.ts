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
 * A compact footer component that renders:
 *   name•model(level)•context%•pwd(branch)
 *
 * Segments are separated by `•` (big dot, no spaces).
 * Hidden segments (no branch, no name, unknown context) are omitted entirely.
 * Session name is left-aligned and bright; model and context are dim.
 * Context percentage is color-coded: yellow (50-80%), red (>=81%).
 * Truncation: when space is tight, pwd and branch are truncated from the right,
 *   name/model/context stay visible on the left.
 */
class FooterComponent implements Component {
  private _focused = false;
  private _dirty = true;
  private _cachedLine = '';
  private _theme: Theme | null = null;

  constructor(
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly ctx: ExtensionContext,
    private readonly getThinkingLevel: () => string,
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
    const full = this.ctx.sessionManager
      .getCwd()
      .replace(process.env.HOME || process.env.USERPROFILE || '', '~');
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
   * Layout: name•model(level)•context%•pwd(branch) — `•` separators, no padding between segments.
   * Model is left-aligned (always visible). Cwd and branch flow immediately after model/context.
   * @param width - Available terminal width
   */
  private buildLine(width: number): string {
    const theme = this._theme;
    if (!theme) return '';

    const cwdParts = this.getCwdParts();
    const branch = this.getBranch();
    const contextUsage = this.getContextUsage();
    const modelBase = this.getModel();
    const level = this.getThinkingLevel();
    // Thinking-level suffix: only for reasoning models, hidden at 'off'
    const model =
      this.ctx.model?.reasoning && level !== 'off'
        ? modelBase + '(' + level.slice(0, 3) + ')'
        : modelBase;
    const name = this.ctx.sessionManager.getSessionName()?.trim() ?? '';

    // ── Build left content (name•model•context%) ─────────────────────
    let leftContent = theme.fg('dim', model);
    let leftWidth = visibleWidth(model);
    if (name) {
      leftContent = theme.fg('text', name) + '•' + leftContent;
      leftWidth += visibleWidth(name) + 1;
    }
    if (contextUsage) {
      let ctxStr: string;
      let ctxColor: 'text' | 'warning' | 'error' = 'text';
      if (contextUsage.tokens !== null && contextUsage.percent !== null) {
        const tokensK =
          contextUsage.tokens >= 1000
            ? `${Math.round(contextUsage.tokens / 1000)}k`
            : contextUsage.tokens;
        ctxStr = `${Math.round(contextUsage.percent)}%/${tokensK}`;
        const pct = Math.round(contextUsage.percent);
        if (pct >= 50 && pct < 81) ctxColor = 'warning';
        else if (pct >= 81) ctxColor = 'error';
      } else {
        const ctxWindow =
          contextUsage.contextWindow >= 1000
            ? `${Math.round(contextUsage.contextWindow / 1000)}k`
            : contextUsage.contextWindow;
        ctxStr = `?/${ctxWindow}`;
      }
      leftContent = leftContent + '•' + theme.fg(ctxColor, ctxStr);
      leftWidth += 1 + visibleWidth(ctxStr);
    }

    // ── Build right content (pwd · branch) ────────────────────────────
    const cwdFor = (idx: number): string => {
      const parts = cwdParts.slice(idx).join('/');
      return idx === 0 ? '/' + parts : parts;
    };

    const cwdStyled = (cwdIdx: number): string => {
      const segments = cwdParts.slice(cwdIdx);
      if (segments.length <= 1) return theme.fg('text', segments[0] || '/');
      const prefix = (cwdIdx === 0 ? '/' : '') + segments.slice(0, -1).join('/') + '/';
      const last = segments[segments.length - 1];
      return theme.fg('dim', prefix) + theme.fg('text', last);
    };

    if (!branch) {
      // No branch — just cwd, right-aligned
      let bestCwdIdx = cwdParts.length - 1;
      for (let i = cwdParts.length - 1; i >= 0; i--) {
        const cwdCandidate = cwdFor(i);
        const cwdWidth = visibleWidth(cwdStyled(i));
        if (cwdWidth + 1 <= width - leftWidth) {
          bestCwdIdx = i;
        } else {
          break;
        }
      }
      return leftContent + '•' + cwdStyled(bestCwdIdx);
    }

    // Branch present — cwd · branch, no padding
    // Start with minimum cwd (last segment), grow left
    let bestCwdIdx = cwdParts.length - 1;

    for (let i = cwdParts.length - 1; i >= 0; i--) {
      const cwdWidth = visibleWidth(cwdStyled(i));
      const branchWidth = visibleWidth(theme.fg('dim', '(' + branch + ')'));

      // Separator (1 char); branch parens glued (no extra chars)
      if (cwdWidth + 1 + branchWidth <= width - leftWidth) {
        bestCwdIdx = i;
      } else {
        break;
      }
    }

    const cwdWidth = visibleWidth(cwdStyled(bestCwdIdx));
    const branchWithParens = '(' + branch + ')';
    const branchWidth = visibleWidth(branchWithParens);
    const available = width - leftWidth - 1 - cwdWidth;

    let finalBranch = branchWithParens;
    if (branchWidth > available) {
      // Truncate branch to fit, preserving parens and adding ellipsis
      const maxBranch = available - 5; // leave room for (...)
      if (maxBranch > 0) {
        finalBranch = '(' + truncateToWidth(branch, maxBranch, '') + '...)';
      } else {
        finalBranch = '(...)';
      }
    }

    return leftContent + '•' + cwdStyled(bestCwdIdx) + theme.fg('dim', finalBranch);
  }

  /** Sanitize extension status text (mirrors pi's default footer). */
  private static sanitizeStatusText(text: string): string {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
  }

  /**
   * Build the conditional extension-status line.
   * Returns null when no extension registered statuses (footer stays one line).
   */
  private buildStatusLine(width: number): string | null {
    const theme = this._theme;
    if (!theme) return null;
    const statuses = this.footerData.getExtensionStatuses();
    if (statuses.size === 0) return null;
    const sorted = Array.from(statuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => FooterComponent.sanitizeStatusText(text));
    return truncateToWidth(theme.fg('dim', sorted.join(' ')), width, theme.fg('dim', '...'));
  }

  /** Render the footer: line 1 always, line 2 only when extensions registered statuses. */
  render(width: number): string[] {
    this._dirty = true;
    if (this._theme) {
      this._cachedLine = this.buildLine(width);
    }
    const lines = [this._cachedLine];
    const statusLine = this.buildStatusLine(width);
    if (statusLine) {
      lines.push(statusLine);
    }
    return lines;
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
 * @param getThinkingLevel - Live getter for the current thinking level (pi.getThinkingLevel)
 * @returns A Component instance that renders the compact footer
 */
export const FooterFactory = (
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  ctx: ExtensionContext,
  getThinkingLevel: () => string,
): Component & { dispose?(): void } => {
  const component = new FooterComponent(footerData, ctx, getThinkingLevel);

  // Initialize with the theme
  component.init(theme);

  // Subscribe to branch changes so we re-render when the branch changes
  footerData.onBranchChange(() => {
    tui.requestRender();
  });

  return component;
};
