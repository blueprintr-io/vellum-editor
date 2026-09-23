import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import textScale from './src/styles/postcss-text-scale.js';

export default {
  // textScale runs after tailwindcss so it sees the generated utilities too.
  plugins: [tailwindcss(), textScale(), autoprefixer()],
};
