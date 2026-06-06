const current = 'A-/';
const mods = current.split('-');
let lastPart = mods[mods.length - 1].toLowerCase();
let modifiers = [];
for (const mod of mods.slice(0, -1)) {
  const m = mod.toLowerCase();
  switch (m) {
    case 'c': modifiers.push('ctrl'); break;
    case 'a': modifiers.push('alt'); break;
    case 's': modifiers.push('shift'); break;
    case 'm': modifiers.push('meta'); break;
  }
}
let combo = [...new Set(modifiers)].sort().concat(lastPart).join('+');
console.log(combo);
