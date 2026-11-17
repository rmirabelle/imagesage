import { Keys, MenuPath, Shot, Tip } from "../parts";

export function Settings() {
  return (
    <>
      <h1>Settings, updates and shortcuts</h1>
      <p className="help-lead">
        The Settings dialog holds the OpenAI key, the local models, and the confirmations. Updates and the
        list of shortcuts are in the Help menu.
      </p>

      <h2>Settings</h2>
      <Shot name="settings-nav" alt="The sections of the Settings dialog" />
      <p>
        <MenuPath path="File > Settings" /> has three sections, each with its status below its name.
        A selection of the OpenAI status in the title bar opens the same dialog.
      </p>
      <p>
        <b>OpenAI</b> stores and tests the API key. <b>Test</b> checks the stored key, and the two buttons
        beside it replace or remove the key. See <i>Getting started</i>.
      </p>
      <p>
        <b>Local</b> installs the engine and selects the model files. See <i>Local models</i>.
      </p>
      <Tip>
        <b>Remove key</b> acts at once, without confirmation.
      </Tip>

      <h2>Confirmations</h2>
      <Shot name="settings-general" alt="The Confirmations in the General section" side="left" />
      <p>
        Image Sage asks before it deletes a layer, and before it regenerates one. <b>Don't show again</b> in
        either dialog turns that confirmation off.
      </p>
      <p>
        The <b>General</b> section turns each confirmation on again.
      </p>

      <h2>Spending</h2>
      <p>
        The title bar shows the amount that OpenAI charged through Image Sage in the current month, once it
        is above zero. The figures come from OpenAI's usage data for each request. Cost estimates in the
        quality list use OpenAI's published prices, which Image Sage reads at start.
      </p>

      <h2>Updates</h2>
      <Shot name="about-dialog" alt="The About Image Sage dialog" />
      <p>
        Image Sage checks for a new version at each start. When one exists, the title bar
        shows <b>Update available</b>.
      </p>
      <p>
        <MenuPath path="Help > About Image Sage" /> shows the installed version. <b>Check for
        Updates</b> looks for a new version, and <b>Download and Install</b> installs it: Image Sage closes,
        updates without setup pages, and opens again.
      </p>

      <h2>Shortcuts and tooltips</h2>
      <p>
        <MenuPath path="Help > Keyboard shortcuts" /> lists every shortcut by tool. The work area also shows
        the shortcuts of the active tool below the image.
      </p>
      <p>
        Rest the pointer on a control to see its description. <Keys k="F1" /> opens this help.
      </p>

      <h2>Use from other programs</h2>
      <p>
        Another program can request local images without a window, with
        the <b>--generate</b> option of <b>imagesage.exe</b> and a request file.
      </p>
    </>
  );
}
