export async function runPageTool(tool, input) {
  try {
    return await globalThis.__opencodeChrome.run(tool, input);
  } catch (error) {
    return { opencodeError: error?.message || 'Page operation failed.' };
  }
}

export function pageResult(result) {
  if (typeof result?.opencodeError === 'string') throw new Error(result.opencodeError);
  return result;
}
