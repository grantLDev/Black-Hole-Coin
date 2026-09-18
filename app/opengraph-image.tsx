import { ImageResponse } from "next/og";
import { TIERS } from "@/config/tiers";
import { TOKEN_NAME, TOKEN_SYMBOL } from "@/config/token";

export const alt = `${TOKEN_NAME} — $${TOKEN_SYMBOL}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TOP_TIER = TIERS[TIERS.length - 1];

/**
 * Static social card. Rendered at build time, not per request — it must not
 * depend on live chain data, since a crawler's snapshot would then contradict
 * the site the moment the numbers move.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#000000",
          position: "relative",
        }}
      >
        {/* Accretion glow */}
        <div
          style={{
            position: "absolute",
            top: 75,
            left: 360,
            width: 480,
            height: 480,
            borderRadius: 480,
            background: `radial-gradient(circle, ${TOP_TIER.diskColorInner} 0%, ${TOP_TIER.diskColorOuter} 42%, rgba(120,40,0,0.35) 62%, rgba(0,0,0,0) 72%)`,
          }}
        />
        {/* Event horizon */}
        <div
          style={{
            position: "absolute",
            top: 202,
            left: 487,
            width: 226,
            height: 226,
            borderRadius: 226,
            background: "#000000",
            boxShadow: `0 0 60px 8px ${TOP_TIER.diskColorInner}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 74,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontSize: 76,
              letterSpacing: 18,
              color: "#ffffff",
              textTransform: "uppercase",
            }}
          >
            {TOKEN_NAME}
          </div>
          <div
            style={{
              marginTop: 14,
              fontSize: 26,
              letterSpacing: 6,
              color: "#8a8f9a",
            }}
          >
            {`$${TOKEN_SYMBOL} · IT ONLY GROWS`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
