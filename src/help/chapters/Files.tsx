import { Keys, MenuPath, ShortcutList, Shot, Tip } from "../parts";

export function Files() {
  return (
    <>
      <h1>Open, save and export</h1>
      <p className="help-lead">
        Image Sage keeps your work in its own document format, which preserves every layer. Export produces
        a flat PNG or JPEG for use elsewhere.
      </p>

      <h2>Open an image</h2>
      <Shot name="open-places" alt="The Places and Drives list of the Open dialog" />
      <p>
        <MenuPath path="File > Open" /> shows Image Sage documents and PNG and JPEG images. Select a file to
        see its preview and details; for a document, the details include the number of AI edits and the last
        prompt. Double-click the file, or select <b>Open</b>.
      </p>
      <p>
        The <b>Show</b> list filters by file type, and the search box filters the current folder by name.
        Right-click a file to rename it, copy it, or delete it.
      </p>
      <Tip>
        <b>Delete</b> in the Open dialog does not ask for confirmation. It moves the file to the Recycle Bin.
      </Tip>
      <p>
        A PNG or JPEG opens as a new document. Image Sage never writes to the source file: the first save
        proposes a document of the same name beside it.
      </p>
      <p>
        GPT Image accepts at most 3840 pixels per side. For a larger file, Image Sage offers
        to <b>Scale down</b> the image or to <b>Keep full size</b>. At full size, each AI edit is sent at a
        reduced size and returns softer.
      </p>

      <h2>Documents and tabs</h2>
      <Shot name="doc-tab" alt="The tab of an open image" />
      <p>
        Each open image has a tab. An asterisk after the name marks unsaved changes, and the amount charged
        for the image follows in brackets. On the active tab of a saved document, select the name to show the
        file in File Explorer.
      </p>
      <p>
        <b>Save</b> (<Keys k="Ctrl+S" />) writes an <b>.imagesage</b> document. It holds all layers, their masks
        and adjustments, the original image, and the prompts. Undo steps are not stored. <b>Save
        As</b> (<Keys k="Ctrl+Shift+S" />) writes a copy under a new name and continues in that copy.
      </p>
      <p>
        Image Sage asks before it closes an image, or the application, with unsaved changes.
      </p>

      <h2>Recovery</h2>
      <p>
        Image Sage copies each unsaved image to a recovery folder about two seconds after the last change.
        If the application stops unexpectedly, the images reopen as unsaved tabs at the next start. A save
        removes the recovery copy, as does a decision to close without saving.
      </p>

      <h2>Import an image as a layer</h2>
      <p>
        <MenuPath path="File > Import Image" /> adds a file to the current image as a new top layer. The
        layer is centered, scaled down if it is larger than the image, and placed in Transform so that you
        can position it. <Keys k="Enter" /> applies the placement.
      </p>

      <h2>Export an image</h2>
      <Shot name="export-dialog" alt="The Export Image dialog" side="left" />
      <p>
        <MenuPath path="File > Export Image" /> (<Keys k="Ctrl+E" />) writes the visible layers as one flat
        image. <b>PNG</b> is lossless and keeps transparency. <b>JPEG</b> gives a smaller file at 92% quality,
        with white in place of transparency.
      </p>
      <p>
        <b>Maximum width</b> and <b>Maximum height</b> reduce the output and keep its proportions; they never
        enlarge it. Select <b>Choose Location</b> to name the file and write it.
      </p>

      <h2>Export all layers</h2>
      <p>
        <MenuPath path="File > Export All Layers" /> asks for a folder and writes one full-size PNG for each
        layer, hidden layers included. Each file holds one layer on a transparent background, with its mask
        and adjustments applied. Blend modes are not applied. Files of the same name in the folder are replaced.
      </p>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["Ctrl+S", "Save"],
          ["Ctrl+Shift+S", "Save As"],
          ["Ctrl+E", "Export Image"]
        ]}
      />
    </>
  );
}
