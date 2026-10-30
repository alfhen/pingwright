/** Matches the whole string. `*` stands for zero or more characters; every other character is literal. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
