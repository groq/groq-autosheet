import '../styles.css'
export const metadata = {
  title: 'Autosheet',
  description: 'JavaScript-powered spreadsheet with chat and MCP',
  icons: [{ rel: 'icon', url: '/favicon.png' }],
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  )
}


