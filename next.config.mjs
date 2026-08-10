/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // pdfjs-dist uses canvas optionally — tell webpack to ignore it
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
