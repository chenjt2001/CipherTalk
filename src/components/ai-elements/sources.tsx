"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BookIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type SourcesProps = ComponentProps<"div">;

export const Sources = ({ className, ...props }: SourcesProps) => (
  <Collapsible
    className={cn("not-prose mb-4 text-primary text-xs", className)}
    {...props}
  />
);

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

export const SourcesTrigger = ({
  className,
  count,
  children,
  ...props
}: SourcesTriggerProps) => (
  <CollapsibleTrigger
    className={cn("flex items-center gap-2", className)}
    {...props}
  >
    {children ?? (
      <>
        <p className="font-medium">Used {count} sources</p>
        <ChevronDownIcon className="h-4 w-4" />
      </>
    )}
  </CollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({
  className,
  ...props
}: SourcesContentProps) => (
  <CollapsibleContent
    className={cn(
      "mt-3 flex w-fit flex-col gap-2",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type SourceProps = ComponentProps<"a">;

const EXTERNAL_HREF_RE = /^(https?:)?\/\//i;

function toExternalHref(href: string): string {
  return href.startsWith("//") ? `https:${href}` : href;
}

export const Source = ({ href, title, children, ...props }: SourceProps) => {
  const external = Boolean(href && EXTERNAL_HREF_RE.test(href));

  return (
    <a
      className="flex items-center gap-2"
      href={href}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || !external || !href) return;
        event.preventDefault();
        void window.electronAPI.shell.openExternal(toExternalHref(href));
      }}
      rel={external ? "noreferrer" : props.rel}
      target={external ? "_blank" : props.target}
    >
      {children ?? (
        <>
          <BookIcon className="h-4 w-4" />
          <span className="block font-medium">{title}</span>
        </>
      )}
    </a>
  );
};
