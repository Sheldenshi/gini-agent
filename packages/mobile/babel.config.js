module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "react" }]
    ],
    plugins: [
      // Reanimated must be listed last so its Babel plugin sees the final AST.
      "react-native-worklets/plugin"
    ]
  };
};
