/**
 * The entire site is one full-viewport WebGL2 surface.
 *
 * This page deliberately renders nothing but the drawing surface: `RendererMount`
 * is a client component that renders no markup of its own, it just attaches the
 * renderer to the canvas below. Keeping the canvas in server-rendered markup
 * means the black frame is painted on first byte, with no white flash before
 * hydration.
 */
import RendererMount from "@/components/RendererMount";
import { SINGULARITY_CANVAS_ID } from "@/lib/gl/canvas";

export default function Page() {
  return (
    <main className="fixed inset-0 h-[100dvh] w-screen overflow-hidden bg-black">
      <canvas
        id={SINGULARITY_CANVAS_ID}
        className="block h-full w-full"
        aria-label="Gravitationally lensed black hole"
        role="img"
      />
      <RendererMount />
    </main>
  );
}
