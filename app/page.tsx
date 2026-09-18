/**
 * The entire site is one full-viewport WebGL2 surface.
 *
 * This page deliberately renders nothing but the drawing surface: the renderer
 * attaches to `#singularity-canvas` in a later prompt. Keeping the canvas in
 * server-rendered markup means the black frame is painted on first byte, with
 * no white flash before hydration.
 */
export default function Page() {
  return (
    <main className="fixed inset-0 h-[100dvh] w-screen overflow-hidden bg-black">
      <canvas
        id="singularity-canvas"
        className="block h-full w-full"
        aria-label="Gravitationally lensed black hole"
        role="img"
      />
    </main>
  );
}
