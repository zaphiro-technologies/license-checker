import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "lib/**", "coverage/**", ".yarn/**"],
  },
  ...tseslint.configs.recommended,
];
