// Panda's PostCSS plugin is what turns the @layer declarations in index.css
// into the actual generated CSS. Without it the layers stay empty and every
// class name resolves to nothing — a page that renders unstyled while every
// build step reports success.
module.exports = {
  plugins: {
    '@pandacss/dev/postcss': {},
  },
}
