namespace ScuroGuardiano.MdLive.Model;

/// <summary>Which point of the preview the source line from a <c>scroll</c> message is aligned to.</summary>
internal enum ScrollAnchor
{
    /// <summary>The line at the top, like the built-in VS Code preview. The default.</summary>
    Top,

    /// <summary>
    /// The line in the middle. What's in the middle of the editor is in the middle of the preview, and differences
    /// in height (e.g. images: one source line, hundreds of pixels) spread to the edges instead of piling up below.
    /// </summary>
    Center
}

internal static class ScrollAnchors
{
    /// <summary><c>"center"</c> is center, anything else (missing, unknown) is top.</summary>
    public static ScrollAnchor Parse(string? value) =>
        string.Equals(value, "center", StringComparison.OrdinalIgnoreCase) ? ScrollAnchor.Center : ScrollAnchor.Top;

    /// <summary>
    /// Where in the preview's height the line goes, 0 (top) to 1 (bottom). An explicit <c>position</c> wins,
    /// otherwise <c>anchor</c>: center is 0.5, top (also missing or unknown) is 0. Editors following the cursor send
    /// the cursor line with the fraction of the editor's height it's at, so it lands at the same height in the preview.
    /// </summary>
    public static double ToPosition(string? anchor, double? position) =>
        position is { } value && double.IsFinite(value)
            ? Math.Clamp(value, 0, 1)
            : Parse(anchor) == ScrollAnchor.Center ? 0.5 : 0;
}
