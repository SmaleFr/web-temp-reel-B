export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (predicate: () => boolean, timeout = 3000) => {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(20);
  }
};
