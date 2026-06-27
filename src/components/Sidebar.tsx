import { useState } from "react";
import "./Sidebar.css";

export interface SidebarItem {
  id: string;
  label: string;
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

const sections: SidebarSection[] = [
  {
    title: "Auto Uploaders",
    items: [
      { id: "card-uploader-auto-upload", label: "CardUploader AutoUpload" },
    ],
  },
  {
    title: "Inventory & Fulfillment",
    items: [
      { id: "inventory",    label: "Inventory" },
      { id: "fulfillment",  label: "Fulfillment" },
    ],
  },
];

interface Props {
  activeId: string;
  onSelect: (id: string) => void;
}

export default function Sidebar({ activeId, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  function handleSelect(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <>
      <button
        className="sidebar-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
      >
        <span className="sidebar-toggle-bar" />
        <span className="sidebar-toggle-bar" />
        <span className="sidebar-toggle-bar" />
      </button>

      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <nav className={`sidebar ${open ? "sidebar--open" : ""}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Tools</span>
        </div>

        {sections.map((section) => (
          <div key={section.title} className="sidebar-section">
            <p className="sidebar-section-title">{section.title}</p>
            <ul className="sidebar-items">
              {section.items.map((item) => (
                <li key={item.id}>
                  <button
                    className={`sidebar-item ${activeId === item.id ? "sidebar-item--active" : ""}`}
                    onClick={() => handleSelect(item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
