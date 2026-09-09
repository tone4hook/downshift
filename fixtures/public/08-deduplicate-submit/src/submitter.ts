export type Save = (key: string, value: string) => Promise<string>;

export function createSubmitter(save: Save): {
  submit(key: string, value: string): Promise<string>;
} {
  return {
    submit(key, value) {
      return save(key, value);
    },
  };
}
