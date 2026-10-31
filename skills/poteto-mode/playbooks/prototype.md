### Prototype

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own the design decision, not the code. The prototype is a throwaway instrument. The real build follows Feature.**

Keep the prototype small and separate from production. Use it to resolve an actual design or behavior question, and compare alternatives when the question calls for them.

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.
2. Gather references when the design space is open. Ask for a user-owned choice only when it cannot be resolved from the request and evidence.
3. Build throwaway in an isolated scratch dir, separate from production source. Use the lightest stack that can answer the question, including the real platform when its behavior matters.
4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.
5. Verify on the matching surface. For a visual decision, screenshot each variant via the control skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

**Reply:** the variants explored, the evidence (screenshots for a visual decision, the observed output or timing for a behavioral one), tradeoffs, your recommendation, and the scratch path. Say plainly that the prototype is throwaway.
