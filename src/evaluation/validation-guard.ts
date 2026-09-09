// Loaded before submitted modules. Explicit exit is never a successful check.
for (const method of ["exit", "reallyExit"]) {
  Object.defineProperty(process, method, {
    configurable: false,
    writable: false,
    value: () => { throw new Error(`Validation rejected premature process.${method}()`); },
  });
}
