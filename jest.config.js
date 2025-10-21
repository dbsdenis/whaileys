module.exports = {
	"roots": [
		"<rootDir>/src"
	],
	"testMatch": [
		"**/Tests/test.*.+(ts|tsx|js)",
	],
	"transform": {
		"^.+\\.(ts|tsx)$": "ts-jest"
	},
	"transformIgnorePatterns": [
		"node_modules/(?!(axios)/)"
	],
}