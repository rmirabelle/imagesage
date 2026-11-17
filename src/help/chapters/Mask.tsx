import { Keys, ShortcutList, Shot, Tip } from "../parts";

export function Mask() {
  return (
    <>
      <h1>The Mask tool</h1>
      <p className="help-lead">
        A layer mask hides parts of a layer, so that the layers below show through. It is the tool that makes
        lossless AI edits possible: keep the part of an edit that you asked for, and hide the rest.
      </p>

      <h2>How a mask works</h2>
      <p>
        A mask belongs to one layer and has the size of the image. Where the mask is white, the layer shows.
        Where it is black, the layer is hidden. Gray shows the layer in part. The pixels of the layer are
        never changed, so a mask can be repainted, turned off, or deleted at any time.
      </p>

      <h2>Add a mask</h2>
      <Shot name="mask-add-menu" alt="The Layer mask menu on a layer's picture" />
      <p>
        Select the small <b>+</b> on the layer's picture and choose <b>Add</b>. The new mask hides the whole
        layer, the Mask tool turns on, and you paint to reveal. This is the usual start after a GPT Image
        edit: reveal only the area that the edit was meant to change.
      </p>
      <p>
        Alternatively, press <Keys k="M" /> to turn on the Mask tool and paint. The first stroke creates the
        mask. A stroke that shows reveals only what you paint; a stroke that hides removes only what you paint.
      </p>

      <h2>The mask toolbar</h2>
      <Shot name="mask-toolbar" alt="The toolbar of the Mask tool" side="block" />
      <p>
        While the Mask tool is on, the toolbar holds the mask tools. The tools
        under <b>Select</b> define an area. The tools under <b>Draw</b> change the mask: the brush and the
        two gradients. <Keys k="Esc" /> leaves the Mask tool.
      </p>

      <h2>Paint the mask</h2>
      <Shot name="mask-brush-settings" alt="The Size, Opacity and Tip settings of the mask brush" />
      <p>
        The brush either shows or hides the layer. <Keys k="X" /> switches between the two, and
        holding <Keys k="Alt" /> paints the opposite for as long as it is held.
      </p>
      <p>
        Drag up or down on <b>Size</b> or <b>Opacity</b> to change the value. A <b>Soft</b> tip blends the
        edit into its surroundings; a <b>Precise</b> tip gives a hard edge.
      </p>
      <Shot name="mask-cards" alt="The status cards of the Mask tool below the image" side="left" />
      <p>
        The cards below the image show the current state: whether the brush shows or hides, whether the red
        view is on, and the active tool with its shortcuts.
      </p>
      <p>
        <Keys k="R" /> turns the red view on or off. The red view covers the hidden areas in red, so that the
        edge of the mask is visible against the image.
      </p>

      <h2>Select, then show or hide</h2>
      <p>
        The <b>Rectangle</b>, <b>Ellipse</b>, <b>Polygon lasso</b> (<Keys k="L" />), and <b>Magic
        wand</b> (<Keys k="W" />) tools make a selection. <Keys k="Alt+Backspace" /> then shows or hides the
        selected area, according to the brush setting. With no selection, it shows or hides the whole layer.
      </p>
      <p>
        A selection also confines the brush and the gradients to its area. In the Mask tool, the Magic wand
        offers <b>Apply</b>, which replaces the mask with the selection. See <i>Selections</i>.
      </p>

      <h2>Mask gradients</h2>
      <Shot name="mask-gradient-ends" alt="The start and end tones of a mask gradient" />
      <p>
        A <b>Linear</b> or <b>Radial gradient</b> fades the layer in or out. Set the start and end tones in
        the toolbar; white shows and black hides. Drag on the image to draw the gradient.
      </p>
      <p>
        The gradient stays editable until you apply it. Click its line to add a stop, click a stop to set
        its tone, and drag a stop off the line to remove it. <Keys k="Enter" /> applies the
        gradient; <Keys k="Esc" /> cancels it.
      </p>

      <h2>The mask in the Layers panel</h2>
      <Shot name="mask-menu" alt="The menu of a layer mask" side="left" />
      <p>
        The mask appears as a small picture on the layer's picture. Select it to paint the mask;
        select it again to leave the Mask tool. <Keys k="Ctrl+Click" /> turns the mask off or on, which shows
        the layer in full for comparison.
      </p>
      <p>
        Right-click the mask to invert, copy, paste, or delete it. A mask pasted within the same image is
        linked to its source: a change to one changes the other, until <b>Unlink</b>.
      </p>
      <Tip>
        Adjustments have masks of their own, which are painted in the same way. See <i>Adjustments</i>.
      </Tip>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["M", "Turn the Mask tool on or off"],
          ["X", "Switch the brush between show and hide"],
          ["Alt", "Hold to paint the opposite"],
          ["R", "Turn the red view on or off"],
          ["[ / ]", "Decrease or increase the brush size"],
          ["1–9 / 0", "Opacity 10% to 90%, or 100%"],
          ["P", "Switch between the Soft and Precise tip"],
          ["L", "Polygon lasso"],
          ["W", "Magic wand"],
          ["B", "Return to the brush"],
          ["Alt+Backspace", "Show or hide the selection, or the whole layer"],
          ["Ctrl+I", "Invert the mask; with a selection, invert the selection"],
          ["Ctrl+Z", "Undo"],
          ["Ctrl+Y", "Redo"],
          ["Esc", "Leave the current tool, then the Mask tool"]
        ]}
      />
    </>
  );
}
