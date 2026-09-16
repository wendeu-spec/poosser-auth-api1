import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { Errors } from "../lib/errors.js";

/**
 * Valide `req.body` contre un schéma Zod. En cas d'échec, renvoie l'erreur
 * générique VALIDATION_ERROR (jamais le détail brut de Zod au client — les
 * noms de champs en échec sont acceptables, les messages internes de Zod non).
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = Object.keys(result.error.flatten().fieldErrors);
      return next(Errors.validation({ fields }));
    }
    req.body = result.data;
    next();
  };
}
