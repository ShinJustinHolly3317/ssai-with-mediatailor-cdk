export const kebabize = (str: string) => {
  return str
    .split('')
    .map((letter, idx) => {
      return letter.toUpperCase() === letter
        ? `${idx !== 0 ? '-' : ''}${letter.toLowerCase()}`
        : letter;
    })
    .join('');
};

export const firstCapitalCamel = (str: string) => {
  if (str === '') {
    return str;
  }
  return (str.charAt(0).toUpperCase() + str.slice(1)).replace(/-./g, (x) =>
    x[1].toUpperCase(),
  );
};