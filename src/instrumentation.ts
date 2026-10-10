export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNodeServer } = await import("./instrumentation-node");
    await startNodeServer();
  }
}
