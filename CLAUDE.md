In this repository we are building a suite of tools to run a card selling business. The tools will have a graphical interface that is created by the Tauri framework.

## Stack

- **Tauri**: v2 (`^2`) — both the Rust crate (`tauri`) and JS/CLI (`@tauri-apps/api`, `@tauri-apps/cli`)
- **Frontend**: React 19, TypeScript, Vite 7
- **Backend**: Rust

## Chaos Sort/Inventory
When it comes to selling cards online, an inventory system is a critical decision to make

This software uses a chaos inventory which uses hyphenated sequences of numbers and letters (or a combination of both) to identify the positions of cards.

For an example consider the following sequence: box1-1-1-1.

This locates a card in box 1, row 1, section 1, card 1. The other preeceding numbers may vary but you can guarantee the last number is the the location of the card in the section.

Consider we had skus ranging from box1-1-1-1 to box1-1-1-50. That would mean box1, row 1, section 1 has 50 cards so when we get an order that corresponds with box1-1-1-32, we look for the 32nd card in that location package it up and ship it.