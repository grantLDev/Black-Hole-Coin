/**
 * The id of the drawing surface.
 *
 * Lives in its own module so that `app/page.tsx` — a server component — can
 * reference it without importing anything that pulls three.js into the server
 * bundle.
 */
export const SINGULARITY_CANVAS_ID = "singularity-canvas";
