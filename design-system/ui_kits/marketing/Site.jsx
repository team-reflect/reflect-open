/* Reflect marketing site — the "deep space" homepage. Composes the glass
   `space` Button + Avatar from the design system; everything sits on the
   .reflect-space themed wrapper. */
const NS_M = 'ReflectDesignSystem_06b075'

const NAV = ['Product', 'Pricing', 'Company', 'Blog', 'Changelog']

const FEATURES = [
  ['Built for speed', 'Instantly sync your notes across devices'],
  ['Networked notes', 'Form a graph of ideas with backlinked notes'],
  ['iOS app', 'Capture ideas on the go, online or offline'],
  ['End-to-end encryption', 'Only you can access your notes'],
  ['Calendar integration', 'Keep track of meetings and agendas'],
  ['Publishing', 'Share anything you write with one click'],
  ['Instant capture', 'Save snippets from your browser and Kindle'],
  ['Frictionless search', 'Easily recall and index past notes and ideas'],
]

const LOVE = [
  [
    'Sean Rose',
    '@seanrose',
    "Really, really liking Reflect so far. It's just the right amount of simple/fast for a personal note taking app.",
  ],
  ['Ryan Delk', '@delk', "Don't take it from me: Reflect is magic."],
  [
    'Fabrizio Rinaldi',
    '@linuz90',
    "I'm keeping Reflect open all the time — for journaling and long-form writing. Rare to see one app work so well for both.",
  ],
  [
    'Jonathan Simcoe',
    '@jdsimcoe',
    'The speed, focus, and attention to detail is superb. It has already become a daily driver for me.',
  ],
]

function Header() {
  const { Button } = window[NS_M]
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        backdropFilter: 'blur(16px)',
        background: 'rgba(3,0,20,.4)',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--site-container)',
          margin: '0 auto',
          padding: '20px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'relative',
        }}
      >
        <a style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="../../assets/reflect-app-icon.png" width="34" height="34" alt="Reflect" />
          <span style={{ fontSize: 16, fontWeight: 500, color: '#fff' }}>Reflect</span>
        </a>
        <ul
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 4,
            listStyle: 'none',
            margin: 0,
            padding: 8,
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--glass-border)',
            background: 'var(--glass-bg)',
          }}
        >
          {NAV.map((n) => (
            <li key={n}>
              <a
                style={{
                  display: 'block',
                  padding: '4px 14px',
                  fontSize: 14,
                  color: 'rgba(255,255,255,.9)',
                  cursor: 'pointer',
                }}
              >
                {n}
              </a>
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <a style={{ fontSize: 14, fontWeight: 500, color: '#fff', cursor: 'pointer' }}>Login</a>
          <Button variant="space">Start free trial</Button>
        </div>
      </div>
    </header>
  )
}

function Hero() {
  const { Button } = window[NS_M]
  return (
    <section style={{ position: 'relative', textAlign: 'center', padding: '70px 24px 30px' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 14px',
          marginBottom: 30,
          borderRadius: 'var(--radius-full)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg)',
          fontSize: 13,
          color: 'rgba(255,255,255,.8)',
        }}
      >
        <span style={{ color: 'var(--purple-light)' }}>✦</span> New: Our AI integration just landed
      </div>
      <h1
        style={{
          margin: '0 auto',
          maxWidth: 760,
          fontSize: 'var(--display-lg)',
          fontWeight: 600,
          lineHeight: 'var(--leading-tight)',
          letterSpacing: 'var(--tracking-tight)',
          color: '#fff',
        }}
      >
        Think better with Reflect
      </h1>
      <p
        style={{ margin: '20px auto 0', fontSize: 'var(--text-xl)', color: 'rgba(255,255,255,.6)' }}
      >
        Never miss a note, idea or connection.
      </p>
      <div style={{ marginTop: 30, display: 'flex', justifyContent: 'center' }}>
        <Button variant="space" style={{ padding: '12px 22px', fontSize: 15 }}>
          Start your 14-day trial
        </Button>
      </div>
      <div style={{ position: 'relative', marginTop: 50 }}>
        <img
          src="../../assets/reflect-graph-hero.png"
          alt="A graph of connected notes"
          style={{ maxWidth: 720, width: '90%', height: 'auto' }}
        />
      </div>
    </section>
  )
}

function Features() {
  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: '60px 28px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 28 }}>
        {FEATURES.map(([t, d]) => (
          <div key={t}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                marginBottom: 14,
                background: 'linear-gradient(180deg, rgba(148,101,255,.4), rgba(113,47,255,.15))',
                border: '1px solid var(--glass-border)',
              }}
            />
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 500, color: '#fff' }}>{t}</h3>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'rgba(255,255,255,.55)' }}>
              {d}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function AIBanner() {
  return (
    <section style={{ textAlign: 'center', padding: '70px 24px' }}>
      <p
        style={{
          margin: '0 0 14px',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '.04em',
          color: 'var(--purple-light)',
        }}
      >
        Reflect AI
      </p>
      <h2
        style={{
          margin: '0 auto',
          maxWidth: 620,
          fontSize: 'var(--display-sm)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          lineHeight: 1.15,
          color: '#fff',
        }}
      >
        Notes with an AI assistant
      </h2>
      <p
        style={{
          margin: '18px auto 0',
          maxWidth: 540,
          fontSize: 17,
          color: 'rgba(255,255,255,.6)',
        }}
      >
        Reflect uses GPT-4 and Whisper from OpenAI to improve your writing, organize your thoughts,
        and act as your intellectual thought partner.
      </p>
    </section>
  )
}

function Pricing() {
  const { Button } = window[NS_M]
  const incl = [
    'Networked note-taking',
    'Chrome &amp; Safari web clipper',
    'Kindle offline sync',
    'End-to-end encryption',
    'iOS app',
    'Native AI assistant',
  ]
  return (
    <section style={{ padding: '40px 24px 80px', textAlign: 'center' }}>
      <p
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '.04em',
          color: 'var(--purple-light)',
        }}
      >
        Get access
      </p>
      <h2
        style={{
          margin: '0 0 36px',
          fontSize: 'var(--display-sm)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          color: '#fff',
        }}
      >
        One plan, one price
      </h2>
      <div
        style={{
          maxWidth: 380,
          margin: '0 auto',
          padding: 32,
          borderRadius: 'var(--radius-2xl)',
          border: '1px solid var(--glass-border)',
          background: 'var(--glass-bg)',
          textAlign: 'left',
          boxShadow: 'inset 0 0 40px rgba(148,101,255,.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 44, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>
            $10
          </span>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,.5)' }}>
            /month, billed annually
          </span>
        </div>
        <ul
          style={{
            listStyle: 'none',
            margin: '22px 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {incl.map((f) => (
            <li
              key={f}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 14,
                color: 'rgba(255,255,255,.8)',
              }}
            >
              <span style={{ color: 'var(--purple-light)' }}>✓</span>
              <span dangerouslySetInnerHTML={{ __html: f }} />
            </li>
          ))}
        </ul>
        <Button
          variant="space"
          style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
        >
          Start your 14-day trial
        </Button>
      </div>
    </section>
  )
}

function Love() {
  const { Avatar } = window[NS_M]
  return (
    <section
      style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 28px 90px', textAlign: 'center' }}
    >
      <p
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '.04em',
          color: 'var(--purple-light)',
        }}
      >
        Wall of love
      </p>
      <h2
        style={{
          margin: '0 0 40px',
          fontSize: 'var(--display-sm)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          color: '#fff',
        }}
      >
        Loved by thinkers
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 18,
          textAlign: 'left',
        }}
      >
        {LOVE.map(([name, handle, quote]) => (
          <div
            key={handle}
            style={{
              padding: 22,
              borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--glass-border)',
              background: 'var(--glass-bg)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <Avatar
                name={name}
                size={36}
                style={{ background: 'rgba(148,101,255,.18)', color: '#cfb8ff' }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{name}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,.45)' }}>{handle}</div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'rgba(255,255,255,.72)' }}>
              {quote}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CTA() {
  const { Button } = window[NS_M]
  return (
    <section style={{ textAlign: 'center', padding: '60px 24px 110px' }}>
      <h2
        style={{
          margin: '0 auto 24px',
          maxWidth: 560,
          fontSize: 'var(--display-md)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          lineHeight: 1.1,
          color: '#fff',
        }}
      >
        Think better with Reflect
      </h2>
      <Button variant="space" style={{ padding: '13px 24px', fontSize: 15 }}>
        Start your 14-day trial
      </Button>
    </section>
  )
}

function Site() {
  return (
    <div
      className="reflect-space"
      style={{
        position: 'relative',
        minHeight: '100%',
        background: 'var(--space-black)',
        overflowX: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(38% 50% at 50% 6%, rgba(148,101,255,.16) 0%, rgba(3,0,20,0) 70%)',
        }}
      />
      <div style={{ position: 'relative' }}>
        <Header />
        <Hero />
        <Features />
        <AIBanner />
        <Pricing />
        <Love />
        <CTA />
      </div>
    </div>
  )
}

window.SiteKit = { Site }
