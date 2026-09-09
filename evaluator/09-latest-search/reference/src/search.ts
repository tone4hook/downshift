export interface SearchState {
  query: string;
  results: string[];
  error: string | null;
}

export function createSearchController(
  fetchResults: (query: string) => Promise<string[]>,
  publish: (state: SearchState) => void,
): { search(query: string): Promise<void> } {
  let latest = 0;
  return {
    async search(query) {
      const request = ++latest;
      try {
        const results = await fetchResults(query);
        if (request === latest) publish({ query, results, error: null });
      } catch (error) {
        if (request === latest) {
          publish({
            query,
            results: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
