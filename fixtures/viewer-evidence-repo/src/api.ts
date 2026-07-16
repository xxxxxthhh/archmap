export const hostileExcerptFixture = '<script>window.__evidenceXss = true</script> https://evil.example/pixel';

export function getUser(): string {
  return hostileExcerptFixture;
}

export function loadRecord(): string {
  return 'record';
}
