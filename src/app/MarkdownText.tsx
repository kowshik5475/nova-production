import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown renderer for NOVA replies: headings, tables, fenced code with a
// language label + copy button, links that open safely outside the shell.

type HastNode = {
  type?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const CodeBlockContext = React.createContext(false)

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  if (Array.isArray(node.children)) return node.children.map(hastText).join('')
  return ''
}

function hastLang(node: HastNode | undefined, depth = 0): string {
  if (!node || depth > 6) return ''
  const className = node.properties?.className
  if (Array.isArray(className)) {
    const hit = className.find(
      (value) => typeof value === 'string' && value.startsWith('language-'),
    )
    if (hit) return String(hit).slice('language-'.length)
  }
  for (const child of node.children ?? []) {
    const found = hastLang(child, depth + 1)
    if (found) return found
  }
  return ''
}

function CodeBlock({
  node,
  children,
  ...rest
}: React.JSX.IntrinsicElements['pre'] & ExtraProps) {
  const language = hastLang(node) || 'text'
  const source = hastText(node)
  const [copied, setCopied] = React.useState(false)

  const copy = () => {
    const fallback = () => {
      const area = document.createElement('textarea')
      area.value = source
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    const done = () => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(source).then(done, () => {
        fallback()
        done()
      })
    } else {
      fallback()
      done()
    }
  }

  return (
    <span className="nova-code">
      <span className="nova-code-head">
        <span className="nova-code-lang">{language}</span>
        <button type="button" className="nova-code-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
      <pre {...rest}>
        <CodeBlockContext.Provider value={true}>{children}</CodeBlockContext.Provider>
      </pre>
    </span>
  )
}

function Code({
  className,
  children,
  ...rest
}: React.JSX.IntrinsicElements['code'] & ExtraProps) {
  const inBlock = React.useContext(CodeBlockContext)
  if (inBlock) {
    return (
      <code {...rest} className={className}>
        {children}
      </code>
    )
  }
  return (
    <code {...rest} className="nova-inline-code">
      {children}
    </code>
  )
}

const components: Components = {
  h1: ({ children }) => <h1 className="nova-md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="nova-md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="nova-md-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="nova-md-h4">{children}</h4>,
  p: ({ children }) => <>{children}</>,
  ul: ({ children }) => <ul className="nova-md-list">{children}</ul>,
  ol: ({ children }) => <ol className="nova-md-list">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => <blockquote className="nova-md-quote">{children}</blockquote>,
  hr: () => <hr className="nova-md-rule" />,
  table: ({ children }) => (
    <span className="nova-md-table-wrap">
      <table className="nova-md-table">{children}</table>
    </span>
  ),
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  pre: CodeBlock,
  code: Code,
}

interface MarkdownTextProps {
  text: string
}

export default function MarkdownText({ text }: MarkdownTextProps) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
}
