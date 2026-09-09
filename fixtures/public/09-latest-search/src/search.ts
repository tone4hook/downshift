export interface SearchState {
  query: string;
  results: string[];
  error: string | null;
}

export function createSearchController(
  fetchResults: (query: string) => Promise<string[]>,
  publish: (state: SearchState) => void,
): { search(query: string): Promise<void> } {
  return {
    async search(query) {
      try {
        publish({ query, results: await fetchResults(query), error: null });
      } catch (error) {
        publish({
          query,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
