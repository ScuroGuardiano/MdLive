using System.Text.Json.Serialization;

namespace ScuroGuardiano.MdLive.Model;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(Content), typeDiscriminator: CommandTypes.Content)]
[JsonDerivedType(typeof(Cursor), typeDiscriminator: CommandTypes.Cursor)]
[JsonDerivedType(typeof(Scroll), typeDiscriminator: CommandTypes.Scroll)]
internal closed record EditorMessage()
{
    internal sealed record Content(string Path, string Text) : EditorMessage;
    internal sealed record Cursor(int Line) :  EditorMessage;

    /// <summary>
    /// Source line at the top (or, with <c>"anchor": "center"</c>, in the middle) of the editor, 1-based, may be
    /// fractional. The preview puts it at the same place.
    /// </summary>
    internal sealed record Scroll(double Line, string? Anchor = null) : EditorMessage;
}
