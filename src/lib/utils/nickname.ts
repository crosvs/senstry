const ADJECTIVES = [
	'swift', 'quiet', 'bright', 'calm', 'bold', 'sharp', 'clear', 'still',
	'quick', 'steady', 'warm', 'cool', 'keen', 'light', 'dark', 'deep',
	'soft', 'firm', 'fast', 'slow', 'wide', 'slim', 'tall', 'lone',
	'wild', 'tame', 'brave', 'free', 'wise', 'fair', 'pure', 'true',
	'old', 'young', 'gold', 'iron', 'stone', 'frost', 'dawn', 'dusk',
	'north', 'south', 'east', 'west', 'inner', 'outer', 'high', 'low',
	'blue', 'grey', 'amber', 'jade'
];

const NOUNS = [
	'falcon', 'cedar', 'river', 'stone', 'maple', 'ridge', 'creek', 'ember',
	'grove', 'hawk', 'pine', 'cliff', 'brook', 'vale', 'peak', 'crest',
	'birch', 'heron', 'fox', 'wolf', 'raven', 'sparrow', 'owl', 'crane',
	'ash', 'oak', 'elm', 'bay', 'cove', 'bluff', 'dune', 'fen',
	'moor', 'glade', 'fern', 'reed', 'moss', 'lichen', 'bolt', 'forge',
	'anvil', 'flint', 'quartz', 'shale', 'chalk', 'slate', 'brine', 'tide',
	'comet', 'beacon'
];

export function generateNickname(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	const num = Math.floor(Math.random() * 90) + 10; // 10–99
	return `${adj}-${noun}-${num}`;
}
