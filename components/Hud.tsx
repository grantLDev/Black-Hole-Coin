"use client";

/**
 * The entire user interface: a tier announcement and a degraded-feed dot.
 *
 * Two elements, both of them silent most of the time. The site is a black hole
 * and the black hole is the content; anything permanently on top of it is
 * competing with it. So the announcement exists for five seconds per unlock
 * and the indicator only appears when the numbers on screen have stopped being
 * live.
 *
 * THE ANNOUNCEMENT'S TIMING IS NOT A CSS ANIMATION OR A setTimeout, and that
 * is deliberate. Both run on wall-clock time: they keep going when the
 * renderer stalls, they keep going when the tab is hidden and the frame loop
 * is cancelled outright (which `Renderer.stop` does, on purpose), and they
 * have no idea the event they belong to was paused. Tying the card to
 * `TierEventQueue`'s clock through a requestAnimationFrame loop means the
 * card, the ripple and the camera push all read the same timeline, always.
 *
 * The bug that made this worth writing down: with a six-second `setTimeout`
 * owning the unmount, `?event=` — which freezes the queue's clock for a
 * screenshot — would hold the card at full opacity and then delete it six real
 * seconds later anyway, so whether it appeared in a capture depended on how
 * slow the machine taking it was. One clock, or none.
 *
 * The loop writes `style.opacity` on a ref rather than calling setState. A
 * 60Hz React render for a number that only drives one CSS property would cost
 * a reconciliation per frame to produce exactly one mutation.
 */

import { useEffect, useRef } from "react";
import { formatUsdCompact } from "@/config/tiers";

export interface Announcement {
  /** Tier name, e.g. "Photon Ring". */
  readonly name: string;
  /** All-time-high market cap threshold that unlocked it, in USD. */
  readonly threshold: number;
  /**
   * Distinguishes consecutive promotions to the same tier index, which cannot
   * happen, from consecutive promotions generally, which very much can — a
   * queued run of unlocks replaces this object every six seconds and the fade
   * must restart rather than continue.
   */
  readonly key: number;
}

export interface HudProps {
  /** The tier being announced, or null when no event is playing. */
  readonly announcement: Announcement | null;
  /**
   * Current announcement opacity, 0..1, read once per frame from the renderer's
   * own event clock. Called from a rAF loop, so it must be cheap and must not
   * allocate.
   */
  readonly announceOpacity: () => number;
  /**
   * Whether a tier-up event is still playing. Polled on the same frame as the
   * opacity, and the only thing that retires the card.
   */
  readonly announceActive: () => boolean;
  /** Called once, from the frame on which the event's slot ends. */
  readonly onAnnounceEnded: () => void;
  /**
   * True when the payload behind the frame is flagged or stale.
   *
   * Never blocks, never covers anything, and deliberately does not say what
   * went wrong: the visitor cannot act on an upstream RPC timeout, and the one
   * thing they can usefully know is that the numbers stopped moving.
   */
  readonly degraded: boolean;
}

export default function Hud({
  announcement,
  announceOpacity,
  announceActive,
  onAnnounceEnded,
  degraded,
}: HudProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !announcement) return;

    let rafId = 0;
    const tick = (): void => {
      if (!announceActive()) {
        onAnnounceEnded();
        return;
      }
      const opacity = announceOpacity();
      card.style.opacity = String(opacity);
      // A few pixels of rise, driven by the same number so the motion and the
      // fade cannot drift apart. The card settles as it arrives.
      card.style.transform = `translateY(${((1 - opacity) * 10).toFixed(2)}px)`;
      rafId = requestAnimationFrame(tick);
    };
    tick();

    return () => cancelAnimationFrame(rafId);
  }, [announcement, announceOpacity, announceActive, onAnnounceEnded]);

  return (
    <>
      {announcement ? (
        <div
          // Keyed so a second promotion arriving six seconds later remounts
          // the card rather than cross-fading one tier's name into another's.
          key={announcement.key}
          ref={cardRef}
          className="pointer-events-none absolute inset-x-0 top-[14%] flex flex-col items-center gap-2 px-6 text-center"
          // Starts invisible. The event's own clock does not reach the fade-in
          // until 0.8s, and a card that flashed at full opacity for one frame
          // before the first rAF would undo the entire cue.
          style={{ opacity: 0 }}
          role="status"
          aria-live="polite"
        >
          <p className="m-0 text-[0.62rem] font-medium uppercase tracking-[0.42em] text-white/40">
            Tier Unlocked
          </p>
          <p className="m-0 text-2xl font-light uppercase tracking-[0.3em] text-white/90 sm:text-4xl">
            {announcement.name}
          </p>
          <p className="m-0 font-mono text-[0.7rem] tracking-[0.25em] text-[color:var(--color-disk)]/70 tabular-nums">
            {formatUsdCompact(announcement.threshold)}
          </p>
        </div>
      ) : null}

      {degraded ? (
        <div
          className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-white/25"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden
            className="inline-block h-[5px] w-[5px] rounded-full bg-[color:var(--color-disk)]/50"
          />
          HOLDING LAST KNOWN
        </div>
      ) : null}
    </>
  );
}
