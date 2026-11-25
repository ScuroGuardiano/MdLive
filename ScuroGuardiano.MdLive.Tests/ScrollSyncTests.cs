using System.Text.Json;
using ScuroGuardiano.MdLive.Model;
using ScuroGuardiano.MdLive.Services;

namespace ScuroGuardiano.MdLive.Tests;

public class ScrollSyncTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        AllowOutOfOrderMetadataProperties = true
    };

    [Theory]
    [InlineData("""{"type":"scroll","line":42}""", 42.0)]
    [InlineData("""{"line":12.5,"type":"scroll"}""", 12.5)]
    public void ScrollMessage_IsDeserialized(string json, double expected)
    {
        var message = JsonSerializer.Deserialize<EditorMessage>(json, Options);

        var scroll = Assert.IsType<EditorMessage.Scroll>(message);
        Assert.Equal(expected, scroll.Line);
    }

    [Fact]
    public void PublishScroll_BumpsVersion_OnlyWhenTheLineChanges()
    {
        var hub = new PreviewHub();

        hub.PublishScroll(10);
        hub.PublishScroll(10);
        Assert.Equal(1, hub.Current.ScrollVersion);

        hub.PublishScroll(10.5);
        Assert.Equal(2, hub.Current.ScrollVersion);
        Assert.Equal(10.5, hub.Current.ScrollLine);
    }

    [Fact]
    public void ScrollAndCursor_AreIndependent()
    {
        var hub = new PreviewHub();

        hub.PublishCursor(5);
        hub.PublishScroll(20);

        Assert.Equal((5, 1L), (hub.Current.CursorLine, hub.Current.CursorVersion));
        Assert.Equal((20.0, 1L), (hub.Current.ScrollLine, hub.Current.ScrollVersion));
    }

    [Theory]
    [InlineData("""{"type":"scroll","line":5,"anchor":"center"}""", "Center")]
    [InlineData("""{"type":"scroll","line":5,"anchor":"CENTER"}""", "Center")]
    [InlineData("""{"type":"scroll","line":5,"anchor":"top"}""", "Top")]
    [InlineData("""{"type":"scroll","line":5}""", "Top")]
    [InlineData("""{"type":"scroll","line":5,"anchor":"sideways"}""", "Top")]
    public void ScrollAnchor_IsParsed_DefaultingToTop(string json, string expected)
    {
        var scroll = Assert.IsType<EditorMessage.Scroll>(JsonSerializer.Deserialize<EditorMessage>(json, Options));

        Assert.Equal(Enum.Parse<ScrollAnchor>(expected), ScrollAnchors.Parse(scroll.Anchor));
    }

    [Fact]
    public void PublishScroll_SameLineDifferentAnchor_IsAChange()
    {
        var hub = new PreviewHub();

        hub.PublishScroll(10, ScrollAnchor.Top);
        hub.PublishScroll(10, ScrollAnchor.Center);
        hub.PublishScroll(10, ScrollAnchor.Center);

        Assert.Equal(2, hub.Current.ScrollVersion);
        Assert.Equal(ScrollAnchor.Center, hub.Current.ScrollAnchor);
    }

    [Theory]
    [InlineData("Top", "top")]
    [InlineData("Center", "center")]
    public void ScriptName_IsAFixedConstant(string anchor, string expected)
    {
        Assert.Equal(expected, Enum.Parse<ScrollAnchor>(anchor).ToScriptName());
    }
}
