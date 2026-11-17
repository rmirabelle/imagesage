import { Keys, ShortcutList, Shot, Tip } from "../parts";

export function Transform() {
  return (
    <>
      <h1>Transform</h1>
      <p className="help-lead">
        Transform moves, scales, and rotates one layer. Use it to place an imported image, or to correct the
        position of an AI result.
      </p>

      <h2>Start Transform</h2>
      <Shot name="transform-frame" alt="A layer in Transform, with corner handles and the Apply and Cancel buttons" />
      <p>
        Select a layer and press <Keys k="Ctrl+T" />, or right-click the layer and
        choose <b>Transform</b>. A frame with four corner handles appears around the visible content of the
        layer. An imported image enters Transform automatically.
      </p>

      <h2>Move, scale, and rotate</h2>
      <Shot name="transform-card" alt="The Transform card with its shortcuts" side="left" />
      <p>
        Drag inside the frame to move the layer. Drag a corner to scale it; the proportions are always kept,
        and the opposite corner stays in place.
      </p>
      <p>
        Drag just outside a corner to rotate the layer around its center. Hold <Keys k="Shift" /> to rotate
        in steps of 15°.
      </p>

      <h2>Apply or cancel</h2>
      <p>
        <Keys k="Enter" />, or the check button, applies the change to the layer, its mask, and the masks of
        its adjustments. <Keys k="Esc" /> cancels. Other tools are unavailable until you do one or the other.
      </p>
      <Tip>
        A layer keeps its source pixels. Repeated transforms do not soften the layer, and content moved
        beyond the edge of the image returns when you move the layer back.
      </Tip>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["Ctrl+T", "Transform the selected layer"],
          ["Shift", "Rotate in steps of 15°"],
          ["Enter", "Apply"],
          ["Esc", "Cancel"]
        ]}
      />
    </>
  );
}
