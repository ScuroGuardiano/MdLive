namespace ScuroGuardiano.MdLive.Model;

/// <param name="ScrollLine">Source line the editor has at <paramref name="ScrollAnchor"/> (scroll sync), see <see cref="EditorMessage.Scroll"/>.</param>
internal sealed record PreviewSnapshot(
    RenderedDocument? Document,
    long DocumentVersion,
    int CursorLine,
    long CursorVersion,
    double ScrollLine = 1,
    long ScrollVersion = 0,
    ScrollAnchor ScrollAnchor = ScrollAnchor.Top)
{
    public static PreviewSnapshot Empty { get; } = new(null, 0, 1, 0);
}
