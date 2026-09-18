import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Shader sources are imported as raw strings from later prompts in this series.
  turbopack: {
    rules: {
      "*.glsl": { loaders: ["raw-loader"], as: "*.js" },
    },
  },
};

export default nextConfig;
