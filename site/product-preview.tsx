import { renderToStaticMarkup } from "react-dom/server";
import { previewClasses as classes } from "./product-preview.stylex.ts";

import { productScenes, productPreviewDisclosure, type ProductScene } from "./product-scenes.ts";

export function ProductPreview({ view = "overview", id = "product-preview" }: Readonly<{view?: ProductScene; id?: string}>) {
  const scene = productScenes[view];
  return <figure className={classes("figure")} data-product-preview={id} data-view={view} id={id}>
    <div className={classes("toolbar")}>
      <div aria-label="Example screen" className={classes("tabs")} role="group">
        {Object.entries(productScenes).map(([key, value]) => <button aria-pressed={key === view} className={`${classes("button")} hraness-material-control hraness-material-choice`} data-preview-view={key} disabled key={key} type="button">{value.label}</button>)}
      </div>
      <button className={classes("button")} data-preview-enlarge="" disabled type="button" aria-haspopup="dialog">Enlarge ↗</button>
    </div>
    <div className={classes("viewport")}>
      <iframe aria-hidden="true" className={classes("frame")} data-preview-frame="" loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts" src={`/examples/app/index.html?view=${view}`} tabIndex={-1} title={`Oompa example: ${scene.label}`} />
    </div>
    <figcaption className={classes("caption")}>
      <p className={classes("description")} data-preview-description="">{scene.description}</p>
      <div className={classes("captionMeta")}>
        <span>{productPreviewDisclosure}</span>
        <a data-preview-guide="" href={scene.guide}>Read the guide ↗</a>
      </div>
      <p className={classes("status")} data-preview-status="" role="status" aria-live="polite">Loading the example interface…</p>
      <p className={classes("status")} data-preview-script-notice="">Screen controls need JavaScript. The written guides cover each workflow.</p>
    </figcaption>
    <dialog aria-labelledby={`${id}-dialog-title`} className={classes("dialog")} data-preview-dialog="">
      <div className={classes("toolbar")}>
        <h2 className={classes("dialogTitle")} id={`${id}-dialog-title`}>Oompa · <span data-preview-dialog-title="">{scene.label}</span></h2>
        <button autoFocus className={classes("button")} data-preview-close="" type="button">Close</button>
      </div>
      <div className={classes("expandedViewport")} data-preview-expanded="" />
      <div className={classes("expandedCaption")}>
        <p className={classes("status")} data-preview-expanded-status="" role="status" aria-live="polite" />
        <p className={classes("status")}>{productPreviewDisclosure}</p>
      </div>
    </dialog>
  </figure>;
}

export const renderProductPreview = (view: ProductScene, id: string): string => renderToStaticMarkup(<ProductPreview id={id} view={view} />);
