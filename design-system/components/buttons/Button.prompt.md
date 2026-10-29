Reflect's button. Solid indigo `primary` for confirming actions; `space` for the dark marketing surface.

```jsx
<Button variant="primary" onClick={save}>Start free trial</Button>
<Button variant="white" size="sm" leadingIcon={<Mic size={14} />}>Record</Button>
<Button variant="space">Start free trial</Button>
```

Variants and sizes are in `Button.d.ts`. Use sentence-case, verb-led labels, never Title Case.
