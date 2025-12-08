/** @type {import('next').NextConfig} */
const nextConfig = {
  // 忽略 TypeScript 错误 (比如类型不匹配)
  typescript: {
    ignoreBuildErrors: true,
  },
  // 忽略 ESLint 错误 (比如定义了变量没使用)
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;