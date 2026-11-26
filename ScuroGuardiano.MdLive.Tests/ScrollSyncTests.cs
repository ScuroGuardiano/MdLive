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
    public void PublishScroll_SameLineDifferentPosition_IsAChange()
    {
        var hub = new PreviewHub();

        hub.PublishScroll(10, 0);
        hub.PublishScroll(10, 0.5);
        hub.PublishScroll(10, 0.5);

        Assert.Equal(2, hub.Current.ScrollVersion);
        Assert.Equal(0.5, hub.Current.ScrollPosition);
    }

    [Theory]
    [InlineData(null, null, 0.0)]
    [InlineData("center", null, 0.5)]
    [InlineData("top", null, 0.0)]
    [InlineData(null, 0.3, 0.3)]
    [InlineData("center", 0.2, 0.2)]
    [InlineData(null, 1.7, 1.0)]
    [InlineData(null, -0.5, 0.0)]
    public void ToPosition_ExplicitPositionWins_AnchorIsAShorthand(string? anchor, double? position, double expected)
    {
        Assert.Equal(expected, ScrollAnchors.ToPosition(anchor, position));
    }

    [Fact]
    public void ScrollMessage_WithPosition_IsDeserialized()
    {
        var scroll = Assert.IsType<EditorMessage.Scroll>(
            JsonSerializer.Deserialize<EditorMessage>("""{"type":"scroll","line":42,"position":0.37}""", Options));

        Assert.Equal(0.37, scroll.Position);
        Assert.Equal(0.37, ScrollAnchors.ToPosition(scroll.Anchor, scroll.Position));
    }
}
