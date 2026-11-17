import { Keys, ShortcutList, Shot, Tip } from "../parts";

export function PaintTool() {
  return (
    <>
      <h1>The Paint tools</h1>
      <p className="help-lead">
        The Paint tools edit the pixels of the selected layer directly. They run on your computer, use no AI
        model, and incur no cost.
      </p>

      <h2>The toolbar</h2>
      <Shot name="paint-toolbar-brush" alt="The toolbar with the Paint brush active" />
      <p>
        The toolbar has two groups. The tools under <b>Select</b> define an area of the layer. The tools
        under <b>Draw</b> apply color. The active tool is highlighted; here it is the Paint brush.
      </p>
      <p>
        <Keys k="Esc" /> exits the active tool and returns to
        the <Shot name="tool-select" alt="Select" side="inline" /> pointer. With the pointer
        active, <Keys k="Ctrl+Click" /> on the image selects the layer under it.
      </p>

      <h2>Selections</h2>
      <p>
        A selection confines every paint operation to its area. The <Shot name="tool-rect" alt="Rectangle select" side="inline" /> <b>Rectangle</b> and <Shot name="tool-ellipse" alt="Ellipse select" side="inline" /> <b>Ellipse</b> tools
        select by a drag. The <Shot name="tool-lasso" alt="Paint lasso" side="inline" /> <b>Lasso</b> (<Keys k="L" />)
        selects a polygon: click to place each point, then click the first point to close the shape.
      </p>
      <Shot name="paint-wand-settings" alt="The Magic wand with its Tolerance, Feather and Contiguous settings" side="left" />
      <p>
        The <Shot name="tool-wand" alt="Magic wand" side="inline" /> <b>Magic wand</b> (<Keys k="W" />) selects
        pixels of a similar color with one click. <b>Tolerance</b> sets how far a color may differ from the
        clicked pixel, and can be adjusted after the click. <b>Feather</b> softens the edge of the
        selection. <b>Contiguous</b> limits the selection to pixels that connect to the clicked pixel.
      </p>
      <p>
        With all four tools, hold <Keys k="Shift" /> to add to the selection and <Keys k="Alt" /> to subtract
        from it. <Keys k="Alt+Backspace" /> fills the selection with the paint color; with no selection, it
        fills the whole layer.
      </p>

      <h2>Brush and eraser</h2>
      <Shot name="paint-brush-settings" alt="The Size, Opacity and Tip settings below the toolbar" />
      <p>
        The <Shot name="tool-brush" alt="Paint brush" side="inline" /> <b>Paint brush</b> (<Keys k="B" />)
        paints with the paint color. The <Shot name="tool-eraser" alt="Eraser" side="inline" /> <b>Eraser</b> removes
        pixels, so the layers below show through.
      </p>
      <p>
        Both tools share the settings that drop down below the toolbar. To change <b>Size</b> or <b>Opacity</b>,
        drag up or down on the value. A <b>Soft</b> tip has a feathered edge; a <b>Precise</b> tip has a hard
        edge.
      </p>

      <h2>Gradients</h2>
      <Shot name="paint-toolbar-gradient" alt="The toolbar with the Linear gradient active and its start and end colors" side="block" />
      <p>
        The <Shot name="tool-linear" alt="Linear gradient" side="inline" /> <b>Linear gradient</b> blends colors
        along a line. The <Shot name="tool-radial" alt="Radial gradient" side="inline" /> <b>Radial gradient</b> blends
        them outward from a center. Set the start and end colors in the toolbar; either color can be
        transparent. Then drag on the image to draw the gradient.
      </p>
      <p>
        The gradient stays editable until you apply it. Click its line to add a color stop, click a stop to
        set its color, and drag a stop off the line to remove it. <Keys k="Enter" /> applies the
        gradient; <Keys k="Esc" /> cancels it.
      </p>

      <h2>The paint color</h2>
      <Shot name="paint-color" alt="The paint color swatch in the toolbar" />
      <p>
        The swatch in the toolbar shows the paint color. Select it to open the color picker.
      </p>
      <Tip>
        With the Paint brush active, <Keys k="Alt+Click" /> on the image takes the color under the pointer.
      </Tip>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["B", "Paint brush"],
          ["L", "Lasso"],
          ["W", "Magic wand"],
          ["[ / ]", "Decrease or increase the brush size"],
          ["1–9 / 0", "Opacity 10% to 90%, or 100%"],
          ["P", "Switch between the Soft and Precise tip"],
          ["Alt+Click", "Take the color under the pointer"],
          ["Alt+Backspace", "Fill the selection, or the whole layer"],
          ["Ctrl+A", "Select all"],
          ["Ctrl+D", "Deselect"],
          ["Ctrl+I", "Invert the selection"],
          ["Ctrl+Z", "Undo"],
          ["Esc", "Exit the active tool"]
        ]}
      />
    </>
  );
}
