import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { CHAPTERS } from "../help/chapters";
import { ShotVersion } from "../help/parts";
import { WindowControls } from "./WindowControls";

const chapterFromHash = () => CHAPTERS.find((chapter) => chapter.id === window.location.hash.slice(1))?.id ?? CHAPTERS[0].id;

/**
 * The help window (Help, Image Sage Help): the chapter list at the left and
 * the selected chapter at the right. The chapters are in src/help/chapters;
 * their pictures are made by the capture run (src/help/capture.ts).
 */
export function HelpWindow() {
  const [chapterId, setChapterId] = useState(chapterFromHash);
  /** Changes when the capture run made new pictures. */
  const [shotVersion, setShotVersion] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stopChapter = listen<string>("help-chapter", (event) => {
      if (CHAPTERS.some((chapter) => chapter.id === event.payload)) setChapterId(event.payload);
    });
    const stopShots = listen("help-shots-updated", () => setShotVersion(Date.now()));
    return () => {
      void stopChapter.then((stop) => stop());
      void stopShots.then((stop) => stop());
    };
  }, []);

  /** Dev only: the layout check (see vite.config.ts) writes a picture of this window at a chapter and scroll place. */
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const preview = async (data: { chapter?: string; scroll?: number; zoom?: number }) => {
      if (data?.chapter && CHAPTERS.some((chapter) => chapter.id === data.chapter)) setChapterId(data.chapter);
      /** A zoom below 1 shows more of the chapter in one picture; the picture is made larger by the same factor, so the text stays readable. */
      const zoom = data?.zoom && data.zoom > 0 && data.zoom < 1 ? data.zoom : 1;
      document.documentElement.style.zoom = String(zoom);
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      pageRef.current?.scrollTo({ top: data?.scroll ?? 0 });
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      await invoke("help_capture", { name: "preview", x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scale: Math.min(4, 1 / zoom) / window.devicePixelRatio })
        .finally(() => { document.documentElement.style.zoom = ""; })
        .then(() => hot.send("imagesage:log", { message: "help preview made" }))
        .catch((error) => hot.send("imagesage:log", { message: `help preview FAILED: ${String(error)}` }));
    };
    hot.on("imagesage:help-preview", preview);
    return () => hot.off("imagesage:help-preview", preview);
  }, []);

  /** A new chapter starts at its top. */
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [chapterId]);

  const index = Math.max(0, CHAPTERS.findIndex((chapter) => chapter.id === chapterId));
  const chapter = CHAPTERS[index];
  const Body = chapter.body;
  const previous = CHAPTERS[index - 1];
  const next = CHAPTERS[index + 1];

  return (
    <main className="app-shell help-window">
      <header className="titlebar" data-tauri-drag-region onDoubleClick={() => void getCurrentWindow().toggleMaximize()}>
        <div className="brand" data-tauri-drag-region>
          <img src="/icon.ico" alt="" />
          <span>Image Sage Help</span>
        </div>
        <div className="titlebar-spacer" data-tauri-drag-region />
        <WindowControls />
      </header>

      <div className="help-layout">
        <nav className="help-nav" aria-label="Chapters">
          {CHAPTERS.map((item, at) => (
            <button key={item.id} className={item.id === chapter.id ? "active" : ""} aria-current={item.id === chapter.id ? "page" : undefined} onClick={() => setChapterId(item.id)}>
              <span className="help-nav-number">{at + 1}</span>
              {item.title}
            </button>
          ))}
        </nav>
        <div className="help-page" ref={pageRef}>
          <ShotVersion.Provider value={shotVersion}>
            <article className="help-article" key={chapter.id}>
              <Body />
              <footer className="help-turn">
                {previous ? <button onClick={() => setChapterId(previous.id)}>‹ {previous.title}</button> : <span />}
                {next ? <button onClick={() => setChapterId(next.id)}>{next.title} ›</button> : <span />}
              </footer>
            </article>
          </ShotVersion.Provider>
        </div>
      </div>
    </main>
  );
}
