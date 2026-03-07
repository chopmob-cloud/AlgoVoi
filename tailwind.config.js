/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Algorand brand
        algo: {
          DEFAULT: "#00D1FF",
          dark: "#0089A8",
        },
        // Voi brand
        voi: {
          DEFAULT: "#6366F1",
          dark: "#4338CA",
        },
        // Extension UI
        surface: {
          0: "#0F0F14",
          1: "#18181F",
          2: "#22222C",
          3: "#2C2C3A",
        },
      },
    },
  },
  plugins: [],
};
