import { Keys, ShortcutList, Shot, Tip } from "../parts";

export function Selections() {
  return (
    <>
      <h1>Selections</h1>
      <p className="help-lead">
        A selection marks an area of the image. It confines paint and mask operations to that area, and it
        defines what Cut and Copy take.
      </p>

      <h2>One selection for all tools</h2>
      <p>
        An image has one selection, shown as a moving dashed outline. It stays in place when you change
        tools, so a selection made with the Paint tools is available to the Mask tool, and the reverse.
        Each change to the selection is an undo step.
      </p>

      <h2>Selection tools</h2>
      <p>
        The <Shot name="tool-rect" alt="Rectangle select" side="inline" /> <b>Rectangle</b> and <Shot name="tool-ellipse" alt="Ellipse select" side="inline" /> <b>Ellipse</b> tools
        select by a drag. Hold <Keys k="Ctrl+Shift" /> during the drag for a square or a circle,
        and <Keys k="Ctrl+Alt" /> to draw from the center.
      </p>
      <p>
        The <Shot name="tool-lasso" alt="Lasso" side="inline" /> <b>Lasso</b> (<Keys k="L" />) selects a
        polygon. Click to place each point. To close the shape, click the first point, double-click, or
        press <Keys k="Enter" />. Before the shape is closed, drag a point to move
        it, <Keys k="Ctrl+Click" /> a point to delete it, or press <Keys k="Backspace" /> to delete the last
        point.
      </p>
      <Shot name="paint-wand-settings" alt="The Tolerance, Feather and Contiguous settings of the Magic wand" />
      <p>
        The <Shot name="tool-wand" alt="Magic wand" side="inline" /> <b>Magic wand</b> (<Keys k="W" />) selects
        pixels of a similar color with one click. It reads the image as it appears, with all visible layers
        combined. <b>Tolerance</b> sets how far a color may differ from the clicked pixel; a change to it
        updates the last click. <b>Feather</b> softens the edge. <b>Contiguous</b> limits the selection to
        pixels that connect to the clicked pixel.
      </p>
      <p>
        <Keys k="Ctrl+Click" /> on a layer's picture in the Layers panel selects the visible pixels of that layer.
      </p>

      <h2>Add and subtract</h2>
      <p>
        With every selection tool, <Keys k="Shift" /> adds the new area to the selection
        and <Keys k="Alt" /> subtracts it. For the Rectangle and Ellipse tools, hold the key when you release
        the mouse button; for the Lasso, when you close the shape.
      </p>

      <h2>Change the selection</h2>
      <Shot name="selection-card" alt="The Selection card with its shortcuts" side="left" />
      <p>
        <Keys k="Ctrl+A" /> selects the whole image. <Keys k="Ctrl+D" /> removes the
        selection. <Keys k="Ctrl+I" /> inverts it. While a selection exists, the <b>Selection</b> card below
        the image lists these commands.
      </p>

      <h2>Cut, copy, and paste</h2>
      <p>
        <Keys k="Ctrl+C" /> copies the selected area as it appears, with all visible layers
        combined. <Keys k="Ctrl+X" /> cuts the area from the selected layer
        only. <Keys k="Ctrl+Shift+X" /> cuts it from every visible layer.
      </p>
      <p>
        <Keys k="Ctrl+V" /> pastes into a new layer above the selected layer, at the original position. The
        copied pixels are available to every open image.
      </p>
      <Tip>
        Image Sage uses its own clipboard for pixels. Copy and paste do not exchange pictures with other
        programs; use Import Image and Export Image for that.
      </Tip>

      <h2>Fill</h2>
      <p>
        With the Paint tools, <Keys k="Alt+Backspace" /> fills the selection with the paint color. With the
        Mask tool, it shows or hides the selected area of the layer.
      </p>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["Ctrl+A", "Select all"],
          ["Ctrl+D", "Deselect"],
          ["Ctrl+I", "Invert the selection"],
          ["Shift", "Add to the selection"],
          ["Alt", "Subtract from the selection"],
          ["Ctrl+C", "Copy what is visible in the selection"],
          ["Ctrl+X", "Cut from the selected layer"],
          ["Ctrl+Shift+X", "Cut from all visible layers"],
          ["Ctrl+V", "Paste as a new layer"],
          ["Alt+Backspace", "Fill, or show or hide, the selection"]
        ]}
      />
    </>
  );
}
