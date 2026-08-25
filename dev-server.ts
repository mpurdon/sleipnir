import index from "./index.html";

const port = Number(process.env.PORT ?? 1420);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  development: {
    hmr: true,
    console: true,
  },
  routes: {
    "/": index,
  },
});

console.log(`sleipnir dev server: ${server.url}`);
