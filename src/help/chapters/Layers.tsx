import { Keys, MenuPath, ShortcutList, Shot, Tip } from "../parts";

export function Layers() {
  return (
    <>
      <h1>Layers</h1>
      <p className="help-lead">
        Every image is a stack of layers. Each AI result, imported file, snapshot, and painted layer is
        separate, so any of them can be hidden, masked, adjusted, or removed without effect on the others.
      </p>

      <h2>The Layers panel</h2>
      <Shot name="layers-panel" alt="The Layers panel with three layers" />
      <p>
        The panel lists the layers from top to bottom, as they are stacked. The opened or first generated
        image is the bottom layer, <b>Original image</b>. It is an ordinary layer.
      </p>
      <p>
        Select a row to select its layer. <Keys k="Ctrl+Click" /> adds a layer to the selection
        and <Keys k="Shift+Click" /> selects a range. Drag a row to change its position in the stack.
      </p>
      <p>
        An AI layer shows its prompt below its name. Double-click a row to rename the layer; a layer with
        its own name shows no prompt.
      </p>
      <p>
        The <b>Filter</b> box finds layers by name, prompt, or model. The close button in the header
        collapses the panel to a strip, and a drag on its left edge changes its width.
      </p>

      <h2>Show and hide</h2>
      <p>
        The <Shot name="layer-eye" alt="The eye button of a layer" side="inline" /> eye shows or hides a
        layer. <Keys k="Ctrl+Click" /> on an eye shows that layer alone; the same action again restores the
        previous state. <b>Show All</b> and <b>None</b> in the panel toolbar set every layer at once.
      </p>

      <h2>Add layers</h2>
      <Shot name="layers-toolbar" alt="The New Layer and Snapshot buttons and the Show buttons" side="left" />
      <p>
        <b>New Layer</b> adds an empty, transparent layer above the selected layer, ready for the Paint tools.
      </p>
      <p>
        <b>Snapshot</b> (<Keys k="Ctrl+Alt+S" />) combines all visible layers into a new top layer. Use it to
        fix a state of the image before further edits.
      </p>
      <p>
        <MenuPath path="File > Import Image" /> adds a file as a new top layer. A paste
        (<Keys k="Ctrl+V" />) of copied pixels adds a layer above the selected one.
      </p>

      <h2>Layer commands</h2>
      <Shot name="layer-menu" alt="The Edit layer menu" />
      <p>
        Right-click a layer for its commands. <b>Transform</b> moves, scales, and rotates
        it. <b>Duplicate</b> places a copy, with its adjustments, directly above. <b>Make Video</b> sends the
        layer to the video window.
      </p>
      <p>
        <b>Delete</b> asks for confirmation, and <Keys k="Ctrl+Z" /> restores the layer. With several layers
        selected, the menu deletes them together.
      </p>

      <h2>Blend mode</h2>
      <Shot name="layer-blend-menu" alt="The Layer blend mode menu" side="left" />
      <p>
        The tag below the layer name shows the blend mode. Select it to
        choose <b>Normal</b>, <b>Screen</b>, or <b>Overlay</b>.
      </p>
      <p>
        A layer has no opacity setting of its own. To make a layer partly transparent, add
        an <b>Opacity</b> adjustment; see <i>Adjustments</i>.
      </p>

      <h2>Masks and adjustments</h2>
      <p>
        The small <b>+</b> on a layer's picture adds a layer mask, and the strip below the name holds the
        layer's adjustments. <Keys k="Ctrl+Click" /> on the picture selects the pixels of the layer.
        See <i>The Mask tool</i> and <i>Adjustments</i>.
      </p>
      <Tip>
        A change to visibility alone does not mark the document as unsaved.
      </Tip>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["Ctrl+T", "Transform the selected layer"],
          ["Ctrl+J", "Duplicate the selected layer"],
          ["Ctrl+Alt+S", "Snapshot of all visible layers"],
          ["Del", "Delete the selected layer"],
          ["Ctrl+Click", "On an eye: show that layer alone"],
          ["Ctrl+Click", "On the image, with the pointer active: select the layer under it"]
        ]}
      />
    </>
  );
}
