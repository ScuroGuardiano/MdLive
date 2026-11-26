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
    /// Source line (1-based, may be fractional) and where it is in the editor's height: <c>"position"</c> 0 to 1,
    /// or <c>"anchor"</c> <c>"top"</c> (0, the default) / <c>"center"</c> (0.5). The preview puts it at the same place.
    /// </summary>
    internal sealed record Scroll(double Line, string? Anchor = null, double? Position = null) : EditorMessage;
}
