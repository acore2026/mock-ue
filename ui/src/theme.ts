import { alpha, createTheme } from '@mui/material/styles'

export const appTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#6750a4',
      light: '#d0bcff',
      dark: '#4f378b',
    },
    secondary: {
      main: '#00639b',
      light: '#9ccaff',
      dark: '#004b77',
    },
    success: {
      main: '#3f6837',
    },
    warning: {
      main: '#9a6700',
    },
    error: {
      main: '#ba1a1a',
    },
    background: {
      default: '#f7f2fa',
      paper: '#fffbfe',
    },
  },
  shape: {
    borderRadius: 18,
  },
  spacing: 8,
  typography: {
    fontFamily: '"Inter Tight", "Roboto Flex", "IBM Plex Sans", "Segoe UI", sans-serif',
    h5: {
      fontWeight: 700,
      letterSpacing: '-0.03em',
    },
    h6: {
      fontWeight: 650,
      letterSpacing: '-0.02em',
    },
    subtitle1: {
      fontWeight: 650,
    },
    overline: {
      fontWeight: 700,
      letterSpacing: '0.12em',
    },
    button: {
      fontWeight: 600,
      letterSpacing: '0.01em',
      textTransform: 'none',
    },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 14,
          minHeight: 40,
        },
        contained: ({ theme }) => ({
          boxShadow: `0 10px 24px ${alpha(theme.palette.primary.main, 0.14)}`,
        }),
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 600,
        },
      },
    },
    MuiSelect: {
      styleOverrides: {
        root: {
          borderRadius: 14,
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 14,
        },
      },
    },
  },
})
