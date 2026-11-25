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

    /// <summary>The name used by the page script, a constant, never input from the editor.</summary>
    public static string ToScriptName(this ScrollAnchor anchor) => anchor == ScrollAnchor.Center ? "center" : "top";
}
